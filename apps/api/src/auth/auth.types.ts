import { CompanyRole } from '@ca/shared';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

export interface MembershipContext {
  companyId: string;
  role: CompanyRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      membership?: MembershipContext;
    }
  }
}

export const SESSION_COOKIE = 'ca_session';
