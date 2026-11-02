import { Inject, Injectable, UnauthorizedException, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { permissionsForRole } from '@ca/shared';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt, randomToken, sha256 } from '../common/crypto';
import { dummyVerify, hashPassword, verifyPassword } from './password';
import { AuthContext } from './auth.types';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const ISSUER = 'Canadian Accounting';

authenticator.options = { window: 1 };
/** Current TOTP time step (otplib's default 30 s step from the Unix epoch). */
const currentStep = () => Math.floor(Date.now() / 1000 / 30);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, mfaCode: string | undefined, ip: string | null, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      await dummyVerify(password);
      await this.audit.record({ action: 'auth.login_failed', ip, metadata: { reason: 'unknown_or_inactive' } });
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.registerFailure(user.id, ip, 'bad_password');
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }
    if (user.mfaEnabled) {
      if (!mfaCode) throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Verification code required' });
      if (!(await this.checkMfa(user.id, user.mfaSecretEnc!, mfaCode))) {
        await this.registerFailure(user.id, ip, 'bad_mfa');
        throw new UnauthorizedException({ code: 'INVALID_MFA', message: 'Invalid verification code' });
      }
    }
    // SaaS sign-ups confirm their e-mail before the first session (invited members and self-hosted users have no such token).
    if (this.config.APP_MODE === 'saas' && !user.emailVerifiedAt && (await this.prisma.emailToken.findFirst({ where: { userId: user.id, purpose: 'verify_email' } }))) {
      throw new HttpException({ code: 'EMAIL_NOT_VERIFIED', message: 'Confirm your e-mail address first: use the link we sent you' }, HttpStatus.FORBIDDEN);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const { token, expiresAt } = await this.createSession(user.id, ip, userAgent);
    await this.audit.record({ action: 'auth.login', actorId: user.id, ip });
    return { token, expiresAt, user: await this.profile(user.id) };
  }

  private async registerFailure(userId: string, ip: string | null, reason: string) {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
    });
    if (u.failedLoginCount >= MAX_FAILURES) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000), failedLoginCount: 0 },
      });
      await this.audit.record({ action: 'auth.account_locked', actorId: userId, ip });
    }
    await this.audit.record({ action: 'auth.login_failed', actorId: userId, ip, metadata: { reason } });
  }

  private async checkMfa(userId: string, secretEnc: string, code: string): Promise<boolean> {
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      const delta = authenticator.checkDelta(clean, decrypt(secretEnc, this.config.ENCRYPTION_KEY));
      if (delta === null) return false;
      return this.consumeStep(userId, currentStep() + delta);
    }
    // Recovery code: single use.
    const res = await this.prisma.recoveryCode.updateMany({
      where: { userId, codeHash: sha256(clean.toLowerCase()), usedAt: null },
      data: { usedAt: new Date() },
    });
    return res.count === 1;
  }

  /**
   * Replay protection: a TOTP code is valid for its 30 s step (±1 step of clock drift), so the same code could otherwise be
   * used again by someone who saw it. Accept a step only if it is newer than the last accepted one; the conditional update
   * makes two simultaneous uses of one code succeed at most once.
   */
  private async consumeStep(userId: string, step: number): Promise<boolean> {
    const r = await this.prisma.user.updateMany({ where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
    return r.count === 1;
  }

  async createSession(userId: string, ip: string | null, userAgent?: string) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.config.SESSION_ABSOLUTE_HOURS * 3_600_000);
    await this.prisma.session.create({
      data: { userId, tokenHash: sha256(token), ip, userAgent: userAgent?.slice(0, 300), expiresAt },
    });
    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    const now = Date.now();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      now - session.lastUsedAt.getTime() > this.config.SESSION_IDLE_HOURS * 3_600_000 ||
      !session.user.isActive
    ) {
      return null;
    }
    // Throttle writes: bump lastUsedAt at most once a minute.
    if (now - session.lastUsedAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    }
    const u = session.user;
    return {
      sessionId: session.id,
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        isSuperAdmin: u.isSuperAdmin,
        mustChangePassword: u.mustChangePassword,
        mfaEnabled: u.mfaEnabled,
      },
    };
  }

  async logout(sessionId: string, userId: string, ip: string | null) {
    await this.prisma.session.updateMany({ where: { id: sessionId, userId }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'auth.logout', actorId: userId, ip });
  }

  async profile(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: 'ACTIVE', company: { isActive: true } },
          include: { company: { select: { id: true, legalName: true, operatingName: true, province: true } } },
          orderBy: { company: { legalName: 'asc' } },
        },
      },
    });
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      isSuperAdmin: u.isSuperAdmin,
      mustChangePassword: u.mustChangePassword,
      mfaEnabled: u.mfaEnabled,
      companies: u.memberships.map((m) => ({
        ...m.company,
        role: m.role,
        permissions: permissionsForRole(m.role),
      })),
    };
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string, ip: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw new BadRequestException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next), mustChangePassword: false },
    });
    // Sign out everywhere else.
    await this.prisma.session.updateMany({
      where: { userId, id: { not: sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ action: 'auth.password_changed', actorId: userId, ip });
  }

  // ---- MFA (TOTP, RFC 6238) ----

  async mfaEnroll(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new BadRequestException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled' });
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecretEnc: encrypt(secret, this.config.ENCRYPTION_KEY) },
    });
    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  async mfaActivate(userId: string, code: string, ip: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaPendingSecretEnc) throw new BadRequestException({ code: 'MFA_NOT_ENROLLING', message: 'Start enrolment first' });
    const secret = decrypt(user.mfaPendingSecretEnc, this.config.ENCRYPTION_KEY);
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null || !(await this.consumeStep(userId, currentStep() + delta))) {
      throw new BadRequestException({ code: 'INVALID_MFA', message: 'Invalid verification code' });
    }
    const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'));
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { mfaEnabled: true, mfaSecretEnc: user.mfaPendingSecretEnc, mfaPendingSecretEnc: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(c) })) }),
    ]);
    await this.audit.record({ action: 'auth.mfa_enabled', actorId: userId, ip });
    return { recoveryCodes: codes };
  }

  async mfaDisable(userId: string, password: string, code: string, ip: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled || !(await verifyPassword(user.passwordHash, password))) {
      throw new BadRequestException({ code: 'INVALID_CREDENTIALS', message: 'Password or code is incorrect' });
    }
    if (!(await this.checkMfa(userId, user.mfaSecretEnc!, code))) {
      throw new BadRequestException({ code: 'INVALID_MFA', message: 'Invalid verification code' });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
    ]);
    await this.audit.record({ action: 'auth.mfa_disabled', actorId: userId, ip });
  }
}
