import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { changePasswordSchema, loginSchema, mfaVerifySchema, LoginInput } from '@ca/shared';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, Public } from './decorators';
import { AuthUser, SESSION_COOKIE } from './auth.types';

const mfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(32) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(CONFIG) private readonly config: AppConfig) {}

  private cookieOptions(expires?: Date) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.config.WEB_ORIGIN.startsWith('https://'),
      path: '/',
      ...(expires ? { expires } : {}),
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body.email, body.password, body.mfaCode, req.ip ?? null, req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, r.token, this.cookieOptions(r.expiresAt));
    return { user: r.user };
  }

  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.auth!.sessionId, user.id, req.ip ?? null);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user.id);
  }

  @HttpCode(204)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(new ZodPipe(changePasswordSchema)) body: { currentPassword: string; newPassword: string },
  ) {
    return this.auth.changePassword(user.id, req.auth!.sessionId, body.currentPassword, body.newPassword, req.ip ?? null);
  }

  @Post('mfa/enroll')
  mfaEnroll(@CurrentUser() user: AuthUser) {
    return this.auth.mfaEnroll(user.id);
  }

  @HttpCode(200)
  @Post('mfa/activate')
  mfaActivate(
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
    @Body(new ZodPipe(mfaVerifySchema)) body: { code: string },
  ) {
    return this.auth.mfaActivate(user.id, body.code, ip);
  }

  @HttpCode(204)
  @Post('mfa/disable')
  mfaDisable(
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string | null,
    @Body(new ZodPipe(mfaDisableSchema)) body: { password: string; code: string },
  ) {
    return this.auth.mfaDisable(user.id, body.password, body.code, ip);
  }
}
